/**
 * Backups, step 7.1 (BACKUP_RECOVERY.md §1, §4, §8; AT-80; P7-1): the key pair, WAL
 * archiving through the command PostgreSQL calls, the nightly dump against a real database
 * (readable, encrypted, opened only with the owner's key, the attached bills alongside), and
 * the banner every device shows when the drive has been missing for 5 minutes.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveWal,
  BackupWatch,
  decrypt,
  makeBackupKeys,
  PRIVATE_KEY_FILE,
  runDump,
  type BackupConfig,
} from '../../src/modules/backup/index.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';

const asApp = (url: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c role=cl_app')}`;
const WAL_CLI = fileURLToPath(new URL('../../src/cli/wal-archive.ts', import.meta.url));
const SEGMENT = '000000010000000000000042';

let work = '';
let usb = '';
let pub = '';
let drive = '';
let keyText = '';
let fx: IdentityFixture;
let clock = new Date();
let drivePlugged = true;
let watch: BackupWatch;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cl-backup-'));
  usb = join(work, 'owner-usb');
  pub = join(work, 'config', 'backup.pub');
  drive = join(work, 'B');
  mkdirSync(join(work, 'config'));
  mkdirSync(drive);
  await makeBackupKeys(usb, pub);
  keyText = readFileSync(join(usb, PRIVATE_KEY_FILE), 'utf8');
  fx = await identityFixture({
    sessionRole: 'cl_app',
    backup: {
      status: () => watch.status(),
    },
  });
  watch = new BackupWatch({
    db: fx.pool,
    driveRoot: drive,
    publicKeyFile: pub,
    now: () => clock,
    drivePresent: () => drivePlugged,
  });
});
afterAll(async () => {
  await fx.close();
  rmSync(work, { recursive: true, force: true });
});

describe('the backup key pair (P7-1)', () => {
  it('private key only on the owner’s USB key, public key on the server, made once', async () => {
    expect(keyText).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/m);
    expect(readFileSync(pub, 'utf8')).toMatch(/^age1[0-9a-z]{58}\n$/);
    expect(readFileSync(pub, 'utf8')).not.toContain('SECRET');
    if (process.platform !== 'win32')
      expect(statSync(join(usb, PRIVATE_KEY_FILE)).mode & 0o077).toBe(0);
    await expect(makeBackupKeys(join(work, 'again'), pub)).rejects.toThrow(
      /already has a backup key/,
    );
  });
});

describe('WAL archiving (BACKUP_RECOVERY.md §1)', () => {
  const wal = () => join(drive, 'CoffeeLounge', 'wal');
  const segment = (fill: number) => {
    const file = join(work, `seg-${String(fill)}`);
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, fill));
    return file;
  };
  const cli = (source: string, name = SEGMENT, root = drive) =>
    spawnSync(
      process.execPath,
      [WAL_CLI, '--drive', root, '--dir', wal(), '--key', pub, source, name],
      { encoding: 'utf8' },
    );

  it('compresses and encrypts a segment; only the owner’s key opens it', async () => {
    const source = segment(7);
    const run = cli(source);
    expect(run.status, run.stderr).toBe(0);
    const stored = readFileSync(join(wal(), `${SEGMENT}.gz.age`));
    expect(stored.length).toBeLessThan(1024 * 1024); // a quiet segment compresses well
    expect(stored.toString('latin1')).toContain('age-encryption.org/v1');
    const plain = gunzipSync(await decrypt(keyText, stored));
    expect(plain.equals(readFileSync(source))).toBe(true);
  });

  it('never overwrites: the same segment again is fine, a different one with its name fails', () => {
    expect(cli(segment(7)).status).toBe(0);
    const clash = cli(segment(8));
    expect(clash.status).toBe(1);
    expect(clash.stderr).toMatch(/refusing to overwrite/);
  });

  it('fails while the drive is unplugged, so PostgreSQL keeps the segment and retries (AT-80)', async () => {
    const name = '000000010000000000000043';
    const missing = cli(segment(9), name, join(work, 'no-drive'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/not plugged in/);
    expect(existsSync(join(wal(), `${name}.gz.age`))).toBe(false);
    // Plugged back in: the retry archives it.
    expect(cli(segment(9), name).status).toBe(0);
    await expect(
      archiveWal({
        driveRoot: drive,
        dir: wal(),
        publicKeyFile: pub,
        sourcePath: segment(9),
        name: '../evil',
      }),
    ).rejects.toThrow(/not a WAL file name/);
  });
});

describe('the nightly dump (BACKUP_RECOVERY.md §1, §4)', () => {
  const config = (): BackupConfig => ({
    driveRoot: drive,
    publicKeyFile: pub,
    pgBinDir: process.env['PG_BIN_DIR'],
    // With only the application role's privileges, as the service login has.
    connectionString: asApp(urlFor(fx.db.name)),
    filesDir: fx.filesDir,
  });

  it('is readable, encrypted, opened only with the owner’s key; the bills go alongside', async () => {
    mkdirSync(join(fx.filesDir, 'expenses'), { recursive: true });
    writeFileSync(join(fx.filesDir, 'expenses', 'bill-1.pdf'), '%PDF-1.4 a bill');
    const at = new Date(Date.now() - 2 * 3600_000);
    const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const r = await runDump(fx.pool, config(), at);
    expect(r, String(r.error)).toMatchObject({ status: 'succeeded', filesCopied: 1 });
    expect(r.path).toBe(join(drive, 'CoffeeLounge', 'dumps', `cl-${stamp}.dump.age`));
    const sealed = readFileSync(r.path ?? '');
    expect(sealed.includes(Buffer.from('PGDMP'))).toBe(false);
    const plain = Buffer.from(await decrypt(keyText, sealed));
    expect(plain.subarray(0, 5).toString()).toBe('PGDMP');
    const bill = readFileSync(join(drive, 'CoffeeLounge', 'files', 'expenses', 'bill-1.pdf.age'));
    expect(Buffer.from(await decrypt(keyText, bill)).toString()).toBe('%PDF-1.4 a bill');
    // The next night copies only new bills.
    expect((await runDump(fx.pool, config(), new Date(Date.now() - 3600_000))).filesCopied).toBe(0);
    const { rows } = await fx.pool.query(
      `SELECT status, size_bytes::int AS size, verified_at IS NOT NULL AS verified FROM cl.backup_runs WHERE id = $1`,
      [r.runId],
    );
    expect(rows[0]).toEqual({ status: 'succeeded', size: sealed.length, verified: true });
  }, 120_000);

  it('a dump that cannot be written is a failed run with its reason', async () => {
    const r = await runDump(
      fx.pool,
      { ...config(), driveRoot: join(work, 'no-drive') },
      new Date(),
    );
    expect(r).toMatchObject({ status: 'failed', error: 'The backup drive is not plugged in' });
  });
});

describe('the backup banner on every device (AT-80)', () => {
  it('drive missing for 5 minutes, last dump failed, overdue; quiet when backups are not set up', async () => {
    const waiter = await (async () => {
      await fx.addUser('bk-waiter', ['waiter']);
      return fx.loggedIn('bk-waiter');
    })();
    const banner = async () =>
      (await waiter.call({ method: 'GET', url: '/api/staff/v1/system/backup-status' })).json<{
        problem: string | null;
        message: string | null;
      }>();
    // The last run (from the test above) failed: that shows first while the drive is in.
    expect(await banner()).toMatchObject({ problem: 'dump_failed' });
    await runDump(
      fx.pool,
      {
        driveRoot: drive,
        publicKeyFile: pub,
        pgBinDir: process.env['PG_BIN_DIR'],
        connectionString: asApp(urlFor(fx.db.name)),
        filesDir: fx.filesDir,
      },
      new Date(),
    );
    clock = new Date();
    expect(await banner()).toEqual({ problem: null, message: null, since: null });
    drivePlugged = false; // the weekly swap: a few seconds, no banner
    expect((await banner()).problem).toBeNull();
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await banner()).toMatchObject({
      problem: 'drive_missing',
      message: expect.stringMatching(/plug in the CL-BACKUP drive/) as unknown,
    });
    drivePlugged = true;
    expect((await banner()).problem).toBeNull();
    clock = new Date(clock.getTime() + 27 * 3600_000);
    expect((await banner()).problem).toBe('dump_overdue');
    const unset = new BackupWatch({ db: fx.pool, now: () => clock });
    expect((await unset.status()).problem).toBeNull();
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const health = (await owner.call({ method: 'GET', url: '/api/staff/v1/system/health' })).json<{
      backup: Record<string, unknown>;
    }>();
    expect(health.backup).toMatchObject({ configured: true, usbDrivePresent: true });
    expect(health.backup['lastSuccessAt']).not.toBeNull();
  }, 120_000);
});
