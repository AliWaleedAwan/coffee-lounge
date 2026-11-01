/**
 * A menu item's photo: a JPEG or PNG of at most 2 MB, kept under FILES_DIR/menu (in the
 * nightly backup, like expense bills) and never inside the database, which keeps only its
 * path. The file name carries the item and the first 12 hex of its SHA-256, so a new
 * photo is a new address and the old one can be cached for ever. The type is taken from
 * the bytes. Guests fetch photos without login (the QR menu shows them); staff with `menu.read`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const FILE = /^(\d+)-([0-9a-f]{12})\.(jpg|png)$/;

function sniff(bytes: Buffer): 'jpg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  return null;
}

function inside(filesDir: string, relative: string): string {
  const full = normalize(join(filesDir, relative));
  if (!full.startsWith(normalize(filesDir) + sep))
    throw new Error(`photo path escapes FILES_DIR: ${relative}`);
  return full;
}

/** Where a client fetches the photo, relative to its API prefix. */
export const photoUrl = (imagePath: string | null): string | null =>
  imagePath ? `menu-photos/${imagePath.slice('menu/'.length)}` : null;

async function changed(
  tx: Tx,
  who: AuditContext,
  itemId: string,
  before: string | null,
  after: string | null,
) {
  await tx.query(
    'UPDATE cl.menu_items SET image_path = $2, updated_at = now(), version = version + 1 WHERE id = $1',
    [itemId, after],
  );
  await writeAudit(tx, who, {
    action: after ? 'menu_item.photo' : 'menu_item.photo_removed',
    entityType: 'menu_item',
    entityId: itemId,
    before: { photo: before },
    after: { photo: after },
  });
  await publish(tx, {
    type: 'menu.changed',
    entityType: 'menu_item',
    entityId: itemId,
    topics: ['menu'],
  });
}

async function lockItem(tx: Tx, itemId: string) {
  const { rows } = await tx.query<{ image_path: string | null; archived_at: Date | null }>(
    'SELECT image_path, archived_at FROM cl.menu_items WHERE id = $1 FOR UPDATE',
    [itemId],
  );
  const item = rows[0];
  if (!item) throw new AppError('NOT_FOUND', 'Menu item not found');
  if (item.archived_at) throw new AppError('STALE_STATE', 'This item is archived');
  return item;
}

export async function setPhoto(
  tx: Tx,
  who: AuditContext,
  filesDir: string,
  itemId: string,
  bytes: Buffer,
): Promise<{ imageUrl: string }> {
  if (bytes.length === 0) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (bytes.length > MAX_PHOTO_BYTES)
    throw new AppError('VALIDATION_FAILED', 'The photo is larger than 2 MB: use a smaller one');
  const ext = sniff(bytes);
  if (!ext) throw new AppError('VALIDATION_FAILED', 'Choose a photo (JPEG or PNG)');
  const item = await lockItem(tx, itemId);
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const relative = `menu/${itemId}-${sha}.${ext}`;
  // Written before the row points at it: a failed transaction leaves only an unused file.
  const full = inside(filesDir, relative);
  await mkdir(dirname(full), { recursive: true });
  const temporary = `${full}.${randomUUID()}.part`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, full);
  if (item.image_path !== relative) await changed(tx, who, itemId, item.image_path, relative);
  return { imageUrl: photoUrl(relative) ?? '' };
}

/** The old file stays on disk: the audit trail names it. */
export async function removePhoto(tx: Tx, who: AuditContext, itemId: string): Promise<void> {
  const item = await lockItem(tx, itemId);
  if (item.image_path) await changed(tx, who, itemId, item.image_path, null);
}

/** GET /menu-photos/:file on a listener. */
export function photoRoute(
  app: FastifyInstance,
  filesDir: string,
  /** Public for guests; on the staff API whoever may read the menu. */
  config: { auth: 'public' } | { permission: 'menu.read' },
): void {
  app.get('/menu-photos/:file', { config }, async (request, reply) => {
    const file = (request.params as { file?: string }).file ?? '';
    const m = FILE.exec(file);
    if (!m) throw new AppError('NOT_FOUND', 'No such photo');
    let bytes: Buffer;
    try {
      bytes = await readFile(inside(filesDir, `menu/${file}`));
    } catch {
      throw new AppError('NOT_FOUND', 'No such photo');
    }
    return reply
      .header('content-type', m[3] === 'png' ? 'image/png' : 'image/jpeg')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(bytes);
  });
}
