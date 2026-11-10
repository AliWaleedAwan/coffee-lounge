/**
 * Administration commands run on the server PC (WINDOWS_DEPLOYMENT.md §6, SECURITY.md §2.2).
 * Access is guarded by the PC itself: only a Windows administrator can read the config
 * file holding the database credentials.
 *
 *   create-owner        --username <u> --name "<display name>"     (password asked twice)
 *   registration-code   --name "<device>" --kind <kind> --ownership shop|personal
 *   recover-owner       --username <u>                             (recovery code + new password asked)
 *   printer-add         --name "<printer>" --connection spooler|tcp --address <queue name or host:port>
 *                       (also makes it the kitchen station's printer)
 *   test-print          --name "<printer>"                         (W-4: the worker prints a test page)
 *   backup-keygen       --out <owner's USB folder>                 (step 7.1: the backup key pair, once;
 *                       the public key goes to BACKUP_PUBLIC_KEY_FILE)
 *   backup-now          [--test-restore]                           (a dump now, as the nightly one;
 *                       with the test restore and its integrity checks)
 *   backup-base                                                    (a base backup now, step 7.2)
 *   restore-dump        --key <owner key file> [--from latest|<file>] [--replace]
 *                       (step 7.3: a nightly dump into DATABASE_URL, which must hold no trading yet)
 *   restore-prepare     --key <owner key file> --to <new data folder> [--time latest|<ISO time>]
 *                       (step 7.3: the newest base backup before the time, set to replay the WAL;
 *                       restore.ps1 runs it with the services stopped)
 *   import-old-pos      --file <old-pos-menu.json> [--dry-run]       (the old POS's products; safe to repeat)
 *   integrity-check                                                (BACKUP_RECOVERY.md §4 on DATABASE_URL)
 *
 * Secrets are typed without echo, or piped one per line by the installer.
 * Usage (from apps/server): corepack pnpm admin <command> [options]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { lineReader, secret } from './input.ts';
import { loadConfig } from '../platform/config.ts';
import { createPool } from '../platform/db/pool.ts';
import { withTransaction } from '../platform/db/tx.ts';
import { AppError } from '../platform/errors.ts';
import {
  backupRoot,
  integrityChecks,
  latestDump,
  makeBackupKeys,
  prepareBaseRestore,
  PRIVATE_KEY_FILE,
  readKeyFile,
  restoreDump,
  runBaseBackup,
  runDump,
  type IntegrityReport,
} from '../modules/backup/index.ts';
import { requestPrint } from '../modules/printing/index.ts';
import {
  applyMenuPlan,
  planMenu,
  type MenuImportResult,
  type OldProduct,
} from '../modules/oldpos/index.ts';
import { DEV_FILES_DIR } from '../platform/paths.ts';
import {
  createOwner,
  createRegistrationCode,
  DEVICE_KINDS,
  recoverOwner,
  type DeviceKind,
} from '../modules/identity/index.ts';

const facts = { correlationId: randomUUID() };

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    ownership: { type: 'string' },
    connection: { type: 'string' },
    address: { type: 'string' },
    out: { type: 'string' },
    'test-restore': { type: 'boolean' },
    key: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    time: { type: 'string' },
    replace: { type: 'boolean' },
    file: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

const command = positionals[0];
const config = loadConfig();
const pool = createPool({ connectionString: config.DATABASE_URL, max: 2 });
const input = lineReader();

function printReport(report: IntegrityReport): void {
  for (const c of report.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(
    report.ok ? 'Integrity: every check passed.' : 'Integrity: PROBLEMS FOUND (see above).',
  );
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`--${flag} is required`);
  return value;
}

try {
  if (command === 'create-owner') {
    const password = await secret(input, 'CL_OWNER_PASSWORD', 'New owner password: ', true);
    const { recoveryCode } = await createOwner(
      pool,
      {
        username: required(values.username, 'username'),
        displayName: required(values.name, 'name'),
        password,
      },
      facts,
    );
    console.log('\nOwner created.');
    console.log(`RECOVERY CODE (print and keep in the safe; shown only once): ${recoveryCode}`);
  } else if (command === 'registration-code') {
    const kind = required(values.kind, 'kind');
    if (!(DEVICE_KINDS as readonly string[]).includes(kind))
      throw new Error(`--kind must be one of ${DEVICE_KINDS.join(', ')}`);
    const ownership = values.ownership === 'personal' ? 'personal' : 'shop';
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text FROM cl.users WHERE is_owner AND status = 'active' ORDER BY users.id LIMIT 1`,
    );
    const owner = rows[0]?.id;
    if (!owner) throw new Error('Create the owner first');
    const { code, expiresAt } = await createRegistrationCode(
      pool,
      { actor: { kind: 'system' }, userId: owner },
      { deviceName: required(values.name, 'name'), kind: kind as DeviceKind, ownership },
      facts,
    );
    console.log(`Registration code: ${code} (valid until ${expiresAt.toLocaleString()})`);
  } else if (command === 'recover-owner') {
    const recoveryCode = await input.ask('Recovery code: ', true);
    const newPassword = await input.ask('New owner password: ', true);
    const { recoveryCode: next } = await recoverOwner(
      pool,
      { username: required(values.username, 'username'), recoveryCode, newPassword },
      facts,
    );
    console.log('\nOwner password reset; all owner sessions ended.');
    console.log(`NEW RECOVERY CODE (the old one no longer works): ${next}`);
  } else if (command === 'printer-add') {
    const connection = required(values.connection, 'connection');
    if (connection !== 'spooler' && connection !== 'tcp')
      throw new Error('--connection must be spooler or tcp');
    const name = required(values.name, 'name');
    await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.printers (name, connection, address) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET connection = EXCLUDED.connection, address = EXCLUDED.address, is_active = true
         RETURNING id::text`,
        [name, connection, required(values.address, 'address')],
      );
      await tx.query('UPDATE cl.stations SET printer_id = $1 WHERE printer_id IS NULL', [
        rows[0]?.id,
      ]);
    });
    console.log(`Printer "${name}" saved; kitchen tickets print there.`);
  } else if (command === 'test-print') {
    const name = required(values.name, 'name');
    const jobId = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id::text FROM cl.printers WHERE name = $1',
        [name],
      );
      const printerId = rows[0]?.id;
      if (printerId === undefined) throw new Error(`No printer named "${name}"`);
      return requestPrint(tx, {
        printerId,
        documentType: 'test_page',
        documentId: printerId,
        jobKey: `test_page:${printerId}:${randomUUID()}`,
      });
    });
    console.log(`Test print ${String(jobId)} queued; the worker service prints it.`);
  } else if (command === 'backup-keygen') {
    const publicFile = required(
      config.BACKUP_PUBLIC_KEY_FILE,
      'BACKUP_PUBLIC_KEY_FILE in the config',
    );
    const recipient = await makeBackupKeys(required(values.out, 'out'), publicFile);
    console.log(
      `Backup key made. Private key: ${join(required(values.out, 'out'), PRIVATE_KEY_FILE)} (keep it, print it, take it away from this PC). Public key ${recipient} in ${publicFile}.`,
    );
  } else if (command === 'backup-now') {
    const r = await runDump(
      pool,
      {
        driveRoot: required(config.BACKUP_DRIVE_PATH, 'BACKUP_DRIVE_PATH in the config'),
        publicKeyFile: required(
          config.BACKUP_PUBLIC_KEY_FILE,
          'BACKUP_PUBLIC_KEY_FILE in the config',
        ),
        pgBinDir: config.PG_BIN_DIR,
        connectionString: config.DATABASE_URL,
        filesDir: config.FILES_DIR ?? DEV_FILES_DIR,
        restoreTestUrl: config.RESTORE_TEST_DATABASE_URL,
      },
      new Date(),
      { testRestore: values['test-restore'] === true },
    );
    if (r.status !== 'succeeded') throw new Error(`backup failed: ${String(r.error)}`);
    if (r.restoreTest && !r.restoreTest.ok)
      throw new Error(`test restore failed: ${r.restoreTest.failed.join('; ')}`);
    if (r.restoreTest) console.log('Test restore: every integrity check passed.');
    console.log(
      `Backup written: ${String(r.path)} (${String(r.sizeBytes)} bytes, ${String(r.filesCopied)} files copied).`,
    );
  } else if (command === 'backup-base') {
    const r = await runBaseBackup(
      pool,
      {
        driveRoot: required(config.BACKUP_DRIVE_PATH, 'BACKUP_DRIVE_PATH in the config'),
        publicKeyFile: required(
          config.BACKUP_PUBLIC_KEY_FILE,
          'BACKUP_PUBLIC_KEY_FILE in the config',
        ),
        pgBinDir: config.PG_BIN_DIR,
        connectionString: config.DATABASE_URL,
        filesDir: config.FILES_DIR ?? DEV_FILES_DIR,
        replicationUrl: required(
          config.BACKUP_REPLICATION_URL,
          'BACKUP_REPLICATION_URL in the config',
        ),
      },
      new Date(),
    );
    if (r.status !== 'succeeded') throw new Error(`base backup failed: ${String(r.error)}`);
    console.log(`Base backup written: ${String(r.path)}`);
  } else if (command === 'restore-dump') {
    const keyText = readKeyFile(required(values.key, 'key'));
    const from = values.from ?? 'latest';
    const dumpFile =
      from === 'latest'
        ? latestDump(required(config.BACKUP_DRIVE_PATH, 'BACKUP_DRIVE_PATH in the config'))
        : from;
    console.log(`Restoring ${dumpFile} …`);
    const report = await restoreDump(
      { pgBinDir: config.PG_BIN_DIR },
      { targetUrl: config.DATABASE_URL, dumpFile, keyText, replace: values.replace === true },
    );
    printReport(report);
    if (!report.ok) process.exitCode = 1;
  } else if (command === 'restore-prepare') {
    const keyFile = required(values.key, 'key');
    const keyText = readKeyFile(keyFile);
    const time = values.time ?? 'latest';
    const target = time === 'latest' ? 'latest' : new Date(time);
    if (target !== 'latest' && Number.isNaN(target.getTime()))
      throw new Error('--time is "latest" or a time such as 2026-11-02T14:30:00+05:00');
    const driveRoot = required(config.BACKUP_DRIVE_PATH, 'BACKUP_DRIVE_PATH in the config');
    const here = dirname(fileURLToPath(import.meta.url));
    const fetchScript = join(
      here,
      existsSync(join(here, 'wal-fetch.js')) ? 'wal-fetch.js' : 'wal-fetch.ts',
    );
    const prepared = await prepareBaseRestore({
      driveRoot,
      keyText,
      dataDir: required(values.to, 'to'),
      target,
      restoreCommand: `"${process.execPath}" "${fetchScript}" ${config.LIVE_WAL_DIR ? `--live "${config.LIVE_WAL_DIR}" ` : ''}--dir "${config.BACKUP_WAL_DIR ?? join(backupRoot(driveRoot), 'wal')}" --key "${keyFile}" "%f" "%p"`,
    });
    console.log(
      `Unpacked ${prepared.baseBackup} (${String(prepared.files)} files); PostgreSQL will replay the WAL to ${time} when it starts.`,
    );
  } else if (command === 'import-old-pos') {
    // Made on a PC with Microsoft Access by scripts/old-pos/export-old-pos.ps1.
    const file = required(values.file, 'file');
    const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
      products?: OldProduct[];
    };
    if (!Array.isArray(data.products)) throw new Error(`${file} has no products list`);
    const plan = planMenu(data.products);
    const { rows: owners } = await pool.query<{ id: string }>(
      'SELECT id::text FROM cl.users WHERE is_owner ORDER BY id LIMIT 1',
    );
    const ownerId = owners[0]?.id;
    if (!ownerId) throw new Error('Create the owner account first.');
    const dryRun = values['dry-run'] === true;
    const ROLLBACK = new Error('dry run');
    let result: MenuImportResult | undefined;
    try {
      await withTransaction(pool, async (tx) => {
        result = await applyMenuPlan(
          tx,
          { actor: { kind: 'user', userId: ownerId }, correlationId: facts.correlationId },
          plan,
        );
        if (dryRun) throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    console.log(dryRun ? 'DRY RUN: nothing was saved. It would make:' : 'Imported:');
    console.log(`  ${String(result?.categoriesCreated)} categories`);
    console.log(`  ${String(result?.itemsCreated)} menu items`);
    console.log(`  ${String(result?.productsCreated)} barcoded products (scan to sell)`);
    console.log(`  ${String(result?.offSale)} of them off sale (out of stock in the old POS)`);
    console.log(`  ${String(result?.alreadyThere)} already there, left as they are`);
    console.log(`Left out (${String(plan.skipped.length)}):`);
    for (const s of plan.skipped) console.log(`  ${s.category} / ${s.name}: ${s.reason}`);
  } else if (command === 'integrity-check') {
    const report = await integrityChecks(pool);
    printReport(report);
    if (!report.ok) process.exitCode = 1;
  } else {
    console.log(
      'Commands: create-owner, registration-code, recover-owner, import-old-pos, printer-add, test-print, backup-keygen, backup-now, backup-base, restore-dump, restore-prepare, integrity-check (see the header of src/cli/admin.ts)',
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    error instanceof AppError || error instanceof Error ? `Error: ${error.message}` : error,
  );
  process.exitCode = 1;
} finally {
  input.close();
  await pool.end();
}
