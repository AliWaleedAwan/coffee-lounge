/**
 * Restores, step 7.3 (BACKUP_RECOVERY.md §5; AT-22): a nightly dump into a fresh database (the
 * replacement PC) with every integrity check passing and the application role's rights back;
 * refusals (wrong key, missing key, a database already trading); a base backup unpacked and
 * set to replay the WAL to a chosen time; the WAL fetch command PostgreSQL calls; and the tar
 * reader refusing a path that would leave its folder. The point-in-time replay itself needs a
 * PostgreSQL this test may stop and start: it runs in Windows CI (restore.ps1).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveWal,
  encrypt,
  extractTar,
  latestDump,
  makeBackupKeys,
  prepareBaseRestore,
  PRIVATE_KEY_FILE,
  readKeyFile,
  readRecipient,
  restoreDump,
  runDump,
} from '../../src/modules/backup/index.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';
import { TradingShop } from '../support/trading.ts';

const FETCH_CLI = fileURLToPath(new URL('../../src/cli/wal-fetch.ts', import.meta.url));
const asApp = (url: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c role=cl_app')}`;

let work = '';
let drive = '';
let pub = '';
let keyFile = '';
let keyText = '';
let fx: IdentityFixture;
let target: TestDatabase;
const pgBinDir = process.env['PG_BIN_DIR'];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cl-restore-'));
  drive = join(work, 'B');
  mkdirSync(drive);
  mkdirSync(join(work, 'config'));
  pub = join(work, 'config', 'backup.pub');
  await makeBackupKeys(join(work, 'usb'), pub);
  keyFile = join(work, 'usb', PRIVATE_KEY_FILE);
  keyText = readKeyFile(keyFile);
  fx = await identityFixture({ sessionRole: 'cl_app' });
  const owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('rs-cash', ['cashier']);
  await fx.addUser('rs-partner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('rs-cash');
  const shop = new TradingShop(fx, owner, cashier, { username: 'rs-partner', pin: '1357' }, 'RS');
  await shop.setUp({ recipe: true });
  await shop.openShift();
  const p = await shop.sale(3, 'cash');
  await shop.sale(1, 'transfer');
  await shop.refund(p, 30);
  await shop.closeShift();
  const r = await runDump(
    fx.pool,
    {
      driveRoot: drive,
      publicKeyFile: pub,
      pgBinDir,
      connectionString: asApp(urlFor(fx.db.name)),
      filesDir: fx.filesDir,
    },
    new Date(),
  );
  expect(r.status, String(r.error)).toBe('succeeded');
  target = await createTestDatabase('empty');
}, 180_000);
afterAll(async () => {
  await target.drop();
  await fx.close();
  rmSync(work, { recursive: true, force: true });
});

describe('a nightly dump onto a replacement PC (§5.1, AT-22)', () => {
  it('restores every record; every integrity check passes; the application role has its rights', async () => {
    const report = await restoreDump(
      { pgBinDir },
      { targetUrl: urlFor(target.name), dumpFile: latestDump(drive), keyText },
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const copy = new pg.Pool({ connectionString: asApp(urlFor(target.name)), max: 1 });
    try {
      const counts = async (db: pg.Pool) =>
        (
          await db.query<{
            invoices: number;
            payments: number;
            users: number;
            ledger: number;
            versions: number;
          }>(
            `SELECT (SELECT count(*)::int FROM cl.invoices) AS invoices, (SELECT count(*)::int FROM cl.payments) AS payments,
                    (SELECT count(*)::int FROM cl.users) AS users, (SELECT count(*)::int FROM cl.ledger_entries) AS ledger,
                    (SELECT count(*)::int FROM cl_meta.schema_migrations) AS versions`,
          )
        ).rows[0];
      // Read as the application role: its grants came back with the data.
      expect(await counts(copy)).toEqual(await counts(fx.pool));
      // The append-only rules came back too.
      await expect(copy.query('DELETE FROM cl.ledger_entries')).rejects.toThrow();
    } finally {
      await copy.end();
    }
  }, 120_000);

  it('refuses a database already trading, a wrong key and a missing key', async () => {
    await expect(
      restoreDump(
        { pgBinDir },
        { targetUrl: urlFor(target.name), dumpFile: latestDump(drive), keyText },
      ),
    ).rejects.toThrow(/already holds trading/);
    await makeBackupKeys(join(work, 'other-usb'), join(work, 'config', 'other.pub'));
    const other = readKeyFile(join(work, 'other-usb', PRIVATE_KEY_FILE));
    await expect(
      restoreDump(
        { pgBinDir },
        {
          targetUrl: urlFor(target.name),
          dumpFile: latestDump(drive),
          keyText: other,
          replace: true,
        },
      ),
    ).rejects.toThrow(/does not open with this key/);
    expect(() => readKeyFile(join(work, 'no-usb', PRIVATE_KEY_FILE))).toThrow(
      /plug in the owner's USB key/,
    );
    expect(() => readKeyFile(pub)).toThrow(/not a Coffee Lounge backup key/);
  }, 60_000);
});

describe('a point in time from a base backup and the WAL (§5.3, §5.4)', () => {
  const tarOf = (dir: string) => {
    const t = spawnSync('tar', ['--format=ustar', '-cf', '-', '-C', dir, '.'], {
      maxBuffer: 1 << 26,
    });
    expect(t.status, t.stderr.toString()).toBe(0);
    return t.stdout;
  };

  it('unpacks the newest base backup before the time and sets the replay', async () => {
    const src = join(work, 'cluster');
    mkdirSync(join(src, 'global'), { recursive: true });
    mkdirSync(join(src, 'base', '5', 'a'.repeat(60)), { recursive: true });
    writeFileSync(join(src, 'PG_VERSION'), '17\n');
    writeFileSync(join(src, 'global', 'pg_control'), Buffer.alloc(8192, 3));
    writeFileSync(join(src, 'base', '5', 'a'.repeat(60), 'b'.repeat(60)), 'deep');
    const sealed = await encrypt(readRecipient(pub), gzipSync(tarOf(src)));
    for (const stamp of ['20261101-0450', '20261102-0450', '20261109-0450']) {
      mkdirSync(join(drive, 'CoffeeLounge', 'base', stamp), { recursive: true });
      writeFileSync(join(drive, 'CoffeeLounge', 'base', stamp, 'base.tar.gz.age'), sealed);
    }
    const dataDir = join(work, 'pgdata-new');
    const prepared = await prepareBaseRestore({
      driveRoot: drive,
      keyText,
      dataDir,
      target: new Date('2026-11-05T12:00:00+05:00'),
      restoreCommand: 'fetch "%f" "%p"',
    });
    expect(prepared.baseBackup).toContain('20261102-0450');
    expect(readFileSync(join(dataDir, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(readFileSync(join(dataDir, 'base', '5', 'a'.repeat(60), 'b'.repeat(60)), 'utf8')).toBe(
      'deep',
    );
    expect(existsSync(join(dataDir, 'recovery.signal'))).toBe(true);
    const conf = readFileSync(join(dataDir, 'postgresql.auto.conf'), 'utf8');
    expect(conf).toContain(`restore_command = 'fetch "%f" "%p"'`);
    expect(conf).toContain("recovery_target_time = '2026-11-05T07:00:00.000Z'");
    expect(conf).toContain("recovery_target_action = 'promote'");
    await expect(
      prepareBaseRestore({
        driveRoot: drive,
        keyText,
        dataDir,
        target: 'latest',
        restoreCommand: 'x',
      }),
    ).rejects.toThrow(/not empty/);
    await expect(
      prepareBaseRestore({
        driveRoot: drive,
        keyText,
        dataDir: join(work, 'pgdata-2'),
        target: new Date('2026-10-01T00:00:00Z'),
        restoreCommand: 'x',
      }),
    ).rejects.toThrow(/No base backup on this drive from before that time/);
  });

  it('a tar entry that would leave its folder is refused', () => {
    const header = Buffer.alloc(512);
    header.write('../evil.txt', 0);
    header.write('0000644\0', 100);
    header.write('00000000004\0', 124);
    header.write('0', 156);
    const tar = Buffer.concat([header, Buffer.from('evil'.padEnd(512, '\0')), Buffer.alloc(1024)]);
    expect(() => extractTar(tar, join(work, 'tar-target'))).toThrow(/outside its folder/);
    expect(existsSync(join(work, 'evil.txt'))).toBe(false);
  });

  it('the WAL fetch command opens an archived segment with the owner key; a missing one ends the replay', async () => {
    const segment = join(work, 'segment');
    writeFileSync(segment, Buffer.alloc(16 * 1024 * 1024, 5));
    const dir = join(drive, 'CoffeeLounge', 'wal');
    await archiveWal({
      driveRoot: drive,
      dir,
      publicKeyFile: pub,
      sourcePath: segment,
      name: '000000010000000000000077',
    });
    const out = join(work, 'fetched');
    const run = (name: string) =>
      spawnSync(process.execPath, [FETCH_CLI, '--dir', dir, '--key', keyFile, name, out], {
        encoding: 'utf8',
      });
    const ok = run('000000010000000000000077');
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(out).equals(readFileSync(segment))).toBe(true);
    expect(run('000000010000000000000078').status).toBe(1);
  });
});
