/**
 * The bill attached to an expense (P5-3): a JPEG, PNG or PDF of at most 5 MB, kept on the
 * server's disk under FILES_DIR (`C:\ProgramData\CoffeeLounge\files`, in the nightly
 * backup, BACKUP_RECOVERY.md) and never inside the database, which keeps its path, type,
 * size and SHA-256. The type is taken from the file's first bytes, not from what the
 * browser says. A replaced file stays on disk: the audit trail names both.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

const EXTENSION: Record<AttachmentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/** What the bytes are, whatever the request claims. */
export function sniffType(bytes: Buffer): AttachmentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** A path inside FILES_DIR, never outside it. */
function inside(filesDir: string, relative: string): string {
  const full = normalize(join(filesDir, relative));
  if (!full.startsWith(normalize(filesDir) + sep))
    throw new Error(`attachment path escapes FILES_DIR: ${relative}`);
  return full;
}

export async function attachBill(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  filesDir: string,
  expenseId: string,
  bytes: Buffer,
): Promise<{ type: AttachmentType; size: number; sha256: string }> {
  if (bytes.length === 0) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The file is larger than 5 MB: take the photo at a lower size',
    );
  }
  const type = sniffType(bytes);
  if (!type)
    throw new AppError('VALIDATION_FAILED', 'Attach a photo (JPEG or PNG) or a PDF of the bill');
  const [expense] = await tx.lock<{
    expense_no: string;
    status: string;
    attachment_path: string | null;
  }>('expenses', [expenseId]);
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found');
  if (expense.status !== 'recorded') {
    throw new AppError(
      'STALE_STATE',
      `${expense.expense_no} is voided: its bill can no longer change`,
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relative = `expenses/${expense.expense_no}-${sha256.slice(0, 12)}.${EXTENSION[type]}`;
  // Written before the row points at it: a failed transaction leaves only an unused file.
  const full = inside(filesDir, relative);
  await mkdir(dirname(full), { recursive: true });
  const temporary = `${full}.${randomUUID()}.part`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, full);
  await tx.query(
    `UPDATE cl.expenses SET attachment_path = $2, attachment_type = $3, attachment_size = $4, attachment_sha256 = $5
      WHERE id = $1`,
    [expenseId, relative, type, bytes.length, sha256],
  );
  await writeAudit(
    tx,
    {
      actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
      correlationId: ctx.correlationId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    },
    {
      action: 'expense.attach',
      entityType: 'expense',
      entityId: expenseId,
      before: { attachment: expense.attachment_path },
      after: { attachment: relative, type, size: bytes.length, sha256 },
    },
  );
  await publish(tx, {
    type: 'expense.changed',
    entityType: 'expense',
    entityId: expenseId,
    topics: ['expenses'],
  });
  return { type, size: bytes.length, sha256 };
}

export async function readBillFile(
  db: Queryable,
  filesDir: string,
  expenseId: string,
): Promise<{ bytes: Buffer; type: string; name: string }> {
  const { rows } = await db.query<{
    expense_no: string;
    attachment_path: string | null;
    attachment_type: string | null;
    attachment_sha256: string | null;
  }>(
    'SELECT expense_no, attachment_path, attachment_type, attachment_sha256 FROM cl.expenses WHERE id = $1',
    [expenseId],
  );
  const row = rows[0];
  if (!row?.attachment_path || !row.attachment_type)
    throw new AppError('NOT_FOUND', 'No bill is attached');
  let bytes: Buffer;
  try {
    bytes = await readFile(inside(filesDir, row.attachment_path));
  } catch {
    throw new AppError(
      'NOT_FOUND',
      'The attached file is missing from the server: restore it from the backup',
    );
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.attachment_sha256) {
    throw new AppError(
      'NOT_FOUND',
      'The attached file on the server does not match what was attached',
    );
  }
  const ext = row.attachment_path.split('.').at(-1) ?? 'bin';
  return { bytes, type: row.attachment_type, name: `${row.expense_no}.${ext}` };
}
