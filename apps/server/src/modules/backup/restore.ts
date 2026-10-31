/**
 * Restores (BACKUP_RECOVERY.md §5; AT-22; step 7.3). Restores are for disasters, never for
 * fixing business mistakes. Every restore needs the owner's private key (on their USB key):
 * nothing on the PC can open a backup by itself.
 *
 * - From a nightly dump (§5.1 with a new PC, §5.2 from the off-site copy): into a database
 *   that holds no trading yet (the fresh install of the replacement PC), then the integrity
 *   checks.
 * - To a point in time from a base backup and the archived WAL (§5.3, §5.4): the newest base
 *   backup before the chosen time is unpacked into a new data folder with the settings that
 *   make PostgreSQL replay the WAL up to that time (or to the end) and then open; the old
 *   folder is kept. The Windows script restore.ps1 stops and starts the services around it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { decrypt } from './keys.ts';
import { backupRoot, runTool, type BackupConfig } from './tools.ts';
import { integrityChecks, type IntegrityReport } from './verify.ts';

/** The owner's key file (from their USB key), refused clearly if it is not one. */
export function readKeyFile(path: string): string {
  if (!existsSync(path))
    throw new Error(`The backup key ${path} is not there: plug in the owner's USB key`);
  const text = readFileSync(path, 'utf8');
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/m.test(text))
    throw new Error(`${path} is not a Coffee Lounge backup key`);
  return text;
}

async function open(keyText: string, file: string): Promise<Buffer> {
  try {
    return Buffer.from(await decrypt(keyText, readFileSync(file)));
  } catch {
    throw new Error(`${file} does not open with this key: is it this shop's key?`);
  }
}

/** The newest nightly dump on the drive. */
export function latestDump(driveRoot: string): string {
  const dir = join(backupRoot(driveRoot), 'dumps');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.dump.age'))
        .sort()
    : [];
  const last = files.at(-1);
  if (!last) throw new Error(`No nightly dump on ${driveRoot}`);
  return join(dir, last);
}

export async function restoreDump(
  c: Pick<BackupConfig, 'pgBinDir'>,
  input: { targetUrl: string; dumpFile: string; keyText: string; replace?: boolean },
): Promise<IntegrityReport> {
  const plain = await open(input.keyText, input.dumpFile);
  const db = new pg.Pool({ connectionString: input.targetUrl, max: 2 });
  try {
    const { rows } = await db
      .query<{ trading: boolean }>(
        `SELECT to_regclass('cl.invoices') IS NOT NULL AND EXISTS (SELECT 1 FROM cl.invoices) AS trading`,
      )
      .catch(() => ({ rows: [{ trading: false }] }));
    if (rows[0]?.trading && !input.replace)
      throw new Error(
        'This database already holds trading; a restore would erase it (use --replace on purpose)',
      );
    await db.query('DROP SCHEMA IF EXISTS cl CASCADE');
    await db.query('DROP SCHEMA IF EXISTS cl_meta CASCADE');
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await runTool(
      c,
      'pg_restore',
      ['--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${input.targetUrl}`],
      plain,
    );
    return await integrityChecks(db);
  } finally {
    await db.end();
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

/** The base backups on the drive, oldest first, with when each was made (from its folder name). */
export function baseBackups(driveRoot: string): { at: Date; file: string }[] {
  const dir = join(backupRoot(driveRoot), 'base');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d{8}-\d{4}(\d{2})?$/.test(d) && existsSync(join(dir, d, 'base.tar.gz.age')))
    .sort()
    .map((d) => ({
      // Folder names are the start, to the second (minute-only names count as the end of that
      // minute), so a restore never picks a base backup that ended after its point in time.
      at: new Date(
        `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.length === 15 ? d.slice(13, 15) : '59'}Z`,
      ),
      file: join(dir, d, 'base.tar.gz.age'),
    }));
}

export interface PreparedRestore {
  baseBackup: string;
  files: number;
  target: Date | 'latest';
}

/**
 * Unpacks the base backup into `dataDir` (a new, empty folder) and sets it to replay the
 * archived WAL through `walFetch` (`"<node>" "<wal-fetch.js>" --dir … --key … "%f" "%p"`).
 */
export async function prepareBaseRestore(input: {
  driveRoot: string;
  keyText: string;
  dataDir: string;
  target: Date | 'latest';
  restoreCommand: string;
}): Promise<PreparedRestore> {
  if (existsSync(input.dataDir) && readdirSync(input.dataDir).length > 0)
    throw new Error(`${input.dataDir} is not empty`);
  const candidates = baseBackups(input.driveRoot).filter(
    (b) => input.target === 'latest' || b.at.getTime() < input.target.getTime(),
  );
  const base = candidates.at(-1);
  if (!base) throw new Error('No base backup on this drive from before that time');
  const tar = gunzipSync(await open(input.keyText, base.file));
  // The system's tar (built into Windows 10 and later, macOS and Linux) unpacks it; like any
  // bsdtar or GNU tar it refuses paths that would leave the folder.
  mkdirSync(input.dataDir, { recursive: true });
  const unpack = spawnSync('tar', ['-xf', '-', '-C', input.dataDir], {
    input: tar,
    maxBuffer: 1 << 20,
  });
  if (unpack.status !== 0)
    throw new Error(
      `tar could not unpack the base backup: ${unpack.stderr.toString().trim().slice(0, 300)}`,
    );
  const files = countFiles(input.dataDir);
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  const settings = [
    '',
    '# --- Coffee Lounge restore (step 7.3) ---',
    `restore_command = ${q(input.restoreCommand)}`,
    ...(input.target === 'latest'
      ? []
      : [
          // PostgreSQL's own format: no 'T', an explicit UTC offset (found by the drill).
          `recovery_target_time = ${q(input.target.toISOString().replace('T', ' ').replace('Z', '+00'))}`,
          "recovery_target_inclusive = 'on'",
        ]),
    "recovery_target_action = 'promote'",
    '',
  ].join('\n');
  writeFileSync(join(input.dataDir, 'postgresql.auto.conf'), settings, { flag: 'a' });
  writeFileSync(join(input.dataDir, 'recovery.signal'), '');
  return { baseBackup: base.file, files, target: input.target };
}
