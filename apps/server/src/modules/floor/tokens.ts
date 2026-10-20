/**
 * Guest-facing secrets (API.md §4, SECURITY.md SR-3).
 *
 * - QR and guest tokens: 128 random bits, base64url; only their SHA-256 is stored.
 * - Entry cookie: `<entryPointId>.<issuedAtSeconds>.<hmac>`, signed with a key the server
 *   keeps in `cl.signing_keys` (created on first use), valid 12 hours. It proves the phone
 *   scanned that QR code recently; it never opens a session or occupies a table.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../../platform/db/pool.ts';

export const ENTRY_COOKIE = 'cl_entry';
export const GUEST_COOKIE = 'cl_guest';
export const ENTRY_TTL_SECONDS = 12 * 3600;
export const GUEST_TTL_SECONDS = 24 * 3600;

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(16).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Shape check before any database lookup. */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

const keys = new WeakMap<object, Buffer>();

/** The entry-cookie key of this database, created once and cached per pool. */
export async function entryKey(db: Queryable & object): Promise<Buffer> {
  const cached = keys.get(db);
  if (cached) return cached;
  await db.query(
    `INSERT INTO cl.signing_keys (purpose, key) VALUES ('guest_entry', $1) ON CONFLICT (purpose) DO NOTHING`,
    [randomBytes(32)],
  );
  const { rows } = await db.query<{ key: Buffer }>(
    `SELECT key FROM cl.signing_keys WHERE purpose = 'guest_entry'`,
  );
  const key = rows[0]?.key;
  if (!key) throw new Error('entry signing key missing');
  keys.set(db, key);
  return key;
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function signEntry(key: Buffer, entryPointId: string, issuedAt: Date): string {
  const payload = `${entryPointId}.${String(Math.floor(issuedAt.getTime() / 1000))}`;
  return `${payload}.${mac(key, payload)}`;
}

/** The entry point id of a valid, unexpired entry cookie, else null. */
export function verifyEntry(key: Buffer, value: unknown, now: Date): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,18})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const [, id = '', issued = '', given = ''] = match;
  const expected = Buffer.from(mac(key, `${id}.${issued}`));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const age = now.getTime() / 1000 - Number(issued);
  if (age < -300 || age > ENTRY_TTL_SECONDS) return null; // small allowance for clock steps
  return id;
}
