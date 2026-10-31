/**
 * The daily off-site copy (BACKUP_RECOVERY.md §1, §4; D-23; P7-2; step 7.2): the newest
 * nightly dump, already encrypted, uploaded to the owner's bucket when the internet is up.
 * While it is down the copy simply waits ("pending", not an error); the next try is 15
 * minutes later. The bucket's secret key is typed by the owner, sealed like the mailbox
 * password, and never returned to a screen or written to a log.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { loadSecretKey, seal, unseal } from '../../platform/secret-box.ts';
import { sha256 } from './keys.ts';
import { putObject, type S3Target } from './s3.ts';

const PURPOSE = 'offsite_target.secret';

export interface OffsiteDeps {
  /** MAIL_KEY_FILE: the key that seals secrets typed on screen. */
  keyFile: string;
  /** Tests: trust the local test bucket's certificate authority. */
  tls?: ConnectionOptions;
}

export interface OffsiteInput {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey?: string | undefined;
  expectedVersion?: number | undefined;
}

interface TargetRow {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_sealed: string;
  updated_at: Date;
  version: number;
}

async function row(db: Queryable): Promise<TargetRow | null> {
  const { rows } = await db.query<TargetRow>(
    `SELECT endpoint, region, bucket, prefix, access_key_id, secret_sealed, updated_at, version
       FROM cl.offsite_target WHERE id = 1`,
  );
  return rows[0] ?? null;
}

export async function readOffsite(db: Queryable) {
  const r = await row(db);
  const { rows } = await db.query<{ at: Date; status: string; error: string | null }>(
    `SELECT COALESCE(finished_at, started_at) AS at, status, error FROM cl.backup_runs
      WHERE kind = 'offsite_copy' ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const last = rows[0];
  return {
    configured: r !== null,
    ...(r
      ? {
          endpoint: r.endpoint,
          region: r.region,
          bucket: r.bucket,
          prefix: r.prefix,
          accessKeyId: r.access_key_id,
          secretSet: true,
          version: r.version,
        }
      : {}),
    last: last ? { at: last.at.toISOString(), status: last.status, error: last.error } : null,
  };
}

export async function saveOffsite(
  tx: Tx,
  ctx: AuditContext & { userId: string },
  deps: OffsiteDeps,
  input: OffsiteInput,
) {
  const before = await row(tx);
  if (before && input.expectedVersion !== undefined && input.expectedVersion !== before.version)
    throw new AppError('STALE_STATE', 'Someone else changed the off-site settings first');
  if (!before && !input.secretAccessKey)
    throw new AppError('VALIDATION_FAILED', 'Enter the bucket’s secret key');
  const sealed = input.secretAccessKey
    ? seal(loadSecretKey(deps.keyFile), PURPOSE, input.secretAccessKey)
    : (before?.secret_sealed ?? '');
  await tx.query(
    `INSERT INTO cl.offsite_target (id, endpoint, region, bucket, prefix, access_key_id, secret_sealed, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET endpoint = $1, region = $2, bucket = $3, prefix = $4,
       access_key_id = $5, secret_sealed = $6, updated_by = $7`,
    [
      input.endpoint,
      input.region,
      input.bucket,
      input.prefix,
      input.accessKeyId,
      sealed,
      ctx.userId,
    ],
  );
  await writeAudit(tx, ctx, {
    action: 'backup.offsite_update',
    entityType: 'offsite_target',
    entityId: '1',
    after: {
      endpoint: input.endpoint,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      secretChanged: Boolean(input.secretAccessKey),
    },
  });
  return readOffsite(tx);
}

async function target(
  db: Queryable,
  deps: OffsiteDeps,
): Promise<(S3Target & { prefix: string }) | null> {
  const r = await row(db);
  if (!r) return null;
  return {
    endpoint: r.endpoint,
    region: r.region,
    bucket: r.bucket,
    prefix: r.prefix,
    accessKeyId: r.access_key_id,
    secretAccessKey: unseal(loadSecretKey(deps.keyFile), PURPOSE, r.secret_sealed),
  };
}

/** "Test": a small object to the bucket now; the bucket's own answer if it fails. */
export async function testOffsite(db: Queryable, deps: OffsiteDeps): Promise<void> {
  const t = await target(db, deps);
  if (!t) throw new AppError('VALIDATION_FAILED', 'Save the off-site settings first');
  try {
    await putObject(
      t,
      `${t.prefix}test.txt`,
      Buffer.from(`Coffee Lounge test ${new Date().toISOString()}\n`),
      {
        ...(deps.tls ? { tls: deps.tls } : {}),
      },
    );
  } catch (e) {
    throw new AppError('VALIDATION_FAILED', e instanceof Error ? e.message : String(e));
  }
}

/** Copies the newest dump not copied yet. Returns what happened, for the worker's log. */
export async function copyOffsite(db: Queryable, deps: OffsiteDeps): Promise<string> {
  const t = await target(db, deps);
  if (!t) return 'not set up';
  // Only the newest dump: an older one never needs to leave once a newer one has.
  const { rows } = await db.query<{ id: string; path: string; copied: boolean }>(
    `SELECT d.id::text, d.path, EXISTS (SELECT 1 FROM cl.backup_runs o WHERE o.kind = 'offsite_copy'
              AND o.status = 'succeeded' AND o.source_run_id = d.id) AS copied
       FROM cl.backup_runs d
      WHERE d.kind = 'dump' AND d.status = 'succeeded' AND d.pruned_at IS NULL
      ORDER BY d.started_at DESC, d.id DESC LIMIT 1`,
  );
  const dump = rows[0];
  if (!dump || dump.copied) return 'up to date';
  let body: Buffer;
  try {
    body = readFileSync(dump.path);
  } catch {
    return 'the dump is on the other drive';
  }
  const key = `${t.prefix}${basename(dump.path)}`;
  try {
    await putObject(t, key, body, { ...(deps.tls ? { tls: deps.tls } : {}) });
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    // One row per dump while it waits: updated on each try, not one per try.
    const updated = await db.query(
      `UPDATE cl.backup_runs SET error = $2, finished_at = now()
        WHERE kind = 'offsite_copy' AND status = 'failed' AND source_run_id = $1`,
      [dump.id, error],
    );
    if (updated.rowCount === 0) {
      await db.query(
        `INSERT INTO cl.backup_runs (kind, status, finished_at, error, source_run_id)
         VALUES ('offsite_copy', 'failed', now(), $2, $1)`,
        [dump.id, error],
      );
    }
    return `pending: ${error}`;
  }
  await db.query(
    `INSERT INTO cl.backup_runs (kind, status, finished_at, path, size_bytes, sha256, source_run_id, verified_at)
     VALUES ('offsite_copy', 'succeeded', now(), $1, $2, $3, $4, now())`,
    [`${t.endpoint}/${t.bucket}/${key}`, body.length, sha256(body), dump.id],
  );
  return `copied ${key}`;
}
