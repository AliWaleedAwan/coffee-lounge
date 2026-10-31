/**
 * The nightly dump (BACKUP_RECOVERY.md §1, §4; step 7.1). After the business day is closed
 * (04:35, once the ledger check and the day-end have run): `pg_dump -Fc` of the shop's data,
 * checked readable with `pg_restore --list`, encrypted to the backup public key and written
 * to the backup drive under a temporary name, then renamed and read back against its
 * checksum. The plain dump only ever exists in memory. The attached bills (FILES_DIR) are
 * copied alongside, each encrypted, only those not copied yet. Each run is a row in
 * `cl.backup_runs`, failed ones with their reason.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { Queryable } from '../../platform/db/pool.ts';
import { encrypt, readRecipient, sha256 } from './keys.ts';

export interface BackupConfig {
  /** The backup drive's root (BACKUP_DRIVE_PATH, `B:\`). */
  driveRoot: string;
  /** The public key (BACKUP_PUBLIC_KEY_FILE). */
  publicKeyFile: string;
  /** PostgreSQL's bin folder (PG_BIN_DIR); unset: pg_dump from the PATH. */
  pgBinDir?: string | undefined;
  /** The database to dump, as the service login. */
  connectionString: string;
  /** Attached bills (FILES_DIR). */
  filesDir: string;
}

/** The shop's folder on the backup drive. */
export const backupRoot = (driveRoot: string) => join(driveRoot, 'CoffeeLounge');

const tool = (c: BackupConfig, name: 'pg_dump' | 'pg_restore') =>
  c.pgBinDir ? join(c.pgBinDir, process.platform === 'win32' ? `${name}.exe` : name) : name;

/** Runs a tool, feeding `input`; its stdout as bytes, or an error with its stderr. */
function run(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} failed (${String(code)}): ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}

function writeDurably(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** Attached bills not copied yet, each encrypted to `<drive>\CoffeeLounge\files\<name>.age`. */
async function copyFiles(c: BackupConfig, recipient: string): Promise<number> {
  const target = join(backupRoot(c.driveRoot), 'files');
  let copied = 0;
  for (const file of filesUnder(c.filesDir)) {
    const out = join(target, `${relative(c.filesDir, file)}.age`);
    if (existsSync(out) && statSync(out).size > 0) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    writeDurably(out, await encrypt(recipient, readFileSync(file)));
    copied += 1;
  }
  return copied;
}

const stamp = (at: Date) => at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export interface DumpResult {
  runId: string;
  status: 'succeeded' | 'failed';
  path: string | null;
  sizeBytes: number | null;
  filesCopied: number;
  error: string | null;
}

export async function runDump(db: Queryable, c: BackupConfig, at: Date): Promise<DumpResult> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.backup_runs (kind, started_at) VALUES ('dump', $1) RETURNING id::text`,
    [at],
  );
  const runId = rows[0]?.id ?? '';
  try {
    if (!existsSync(c.driveRoot)) throw new Error('The backup drive is not plugged in');
    const recipient = readRecipient(c.publicKeyFile);
    const plain = await run(tool(c, 'pg_dump'), [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--schema=cl',
      '--schema=cl_meta',
      `--dbname=${c.connectionString}`,
    ]);
    // Readable: the table of contents lists the shop's tables (BACKUP_RECOVERY.md §4).
    const toc = (await run(tool(c, 'pg_restore'), ['--list'], plain)).toString();
    for (const table of ['invoices', 'payments', 'stock_movements', 'ledger_entries'])
      if (!toc.includes(`TABLE DATA cl ${table}`)) throw new Error(`the dump has no ${table}`);
    const sealed = await encrypt(recipient, plain);
    const dir = join(backupRoot(c.driveRoot), 'dumps');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `cl-${stamp(at)}.dump.age`);
    writeDurably(path, sealed);
    const sum = sha256(sealed);
    if (sha256(readFileSync(path)) !== sum) throw new Error('the written dump does not read back');
    const filesCopied = await copyFiles(c, recipient);
    await db.query(
      `UPDATE cl.backup_runs SET status = 'succeeded', finished_at = now(), path = $2, size_bytes = $3,
              sha256 = $4, files_copied = $5, verified_at = now() WHERE id = $1`,
      [runId, path, sealed.length, sum, filesCopied],
    );
    return { runId, status: 'succeeded', path, sizeBytes: sealed.length, filesCopied, error: null };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query(
      `UPDATE cl.backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, error],
    );
    return { runId, status: 'failed', path: null, sizeBytes: null, filesCopied: 0, error };
  }
}
