/**
 * What the backup jobs share (step 7.1, 7.2): their configuration, the shop's folder on the
 * drive, running the PostgreSQL tools, and writing a file so a half-written one never has
 * the final name.
 */
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

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
  /** The scratch database the weekly test restore uses (RESTORE_TEST_DATABASE_URL, step 7.2). */
  restoreTestUrl?: string | undefined;
}

/** The shop's folder on the backup drive. */
export const backupRoot = (driveRoot: string) => join(driveRoot, 'CoffeeLounge');

const tool = (
  c: Pick<BackupConfig, 'pgBinDir'>,
  name: 'pg_dump' | 'pg_restore' | 'pg_basebackup',
) => (c.pgBinDir ? join(c.pgBinDir, process.platform === 'win32' ? `${name}.exe` : name) : name);

/** Runs a PostgreSQL tool from the configured folder. */
export const runTool = (
  c: Pick<BackupConfig, 'pgBinDir'>,
  name: 'pg_dump' | 'pg_restore' | 'pg_basebackup',
  args: string[],
  input?: Buffer,
) => run(tool(c, name), args, input);

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

export function writeDurably(path: string, data: Uint8Array): void {
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

export const stampOf = (at: Date) =>
  at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
