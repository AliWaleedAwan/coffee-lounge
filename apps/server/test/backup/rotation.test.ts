/**
 * Backups, step 7.2 (BACKUP_RECOVERY.md §1–§4; AT-81; D-23; P7-2, P7-3): the weekly test
 * restore and its six integrity checks (each caught on a deliberately broken copy), the
 * drives' identities, base backups (where this login may replicate: CI), retention, and the
 * off-site copy to a local test bucket over HTTPS (queued while it cannot be reached).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseBackupDue,
  BackupWatch,
  copyOffsite,
  decrypt,
  identifyDrive,
  integrityChecks,
  makeBackupKeys,
  PRIVATE_KEY_FILE,
  prepareBaseRestore,
  pruneBackups,
  runBaseBackup,
  runDump,
  type BackupConfig,
} from '../../src/modules/backup/index.ts';
import { dumpsToKeep } from '../../src/modules/backup/retention.ts';
import { signV4 } from '../../src/modules/backup/s3.ts';
import { createRootCa, issueServerCertificate } from '../../src/platform/x509.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { TradingShop } from '../support/trading.ts';

const asApp = (url: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c role=cl_app')}`;

let work = '';
let drive = '';
let pub = '';
let keyText = '';
let fx: IdentityFixture;
let owner: Client;
let scratch: TestDatabase;
let config: BackupConfig;
let bucketCa: ReturnType<typeof createRootCa>;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cl-rotation-'));
  drive = join(work, 'B');
  mkdirSync(drive);
  mkdirSync(join(work, 'config'));
  pub = join(work, 'config', 'backup.pub');
  await makeBackupKeys(join(work, 'usb'), pub);
  keyText = readFileSync(join(work, 'usb', PRIVATE_KEY_FILE), 'utf8');
  bucketCa = createRootCa({ commonName: 'Test bucket CA', passphrase: 'x-test-passphrase' });
  fx = await identityFixture({ sessionRole: 'cl_app', mailTls: { ca: bucketCa.certificatePem } });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  scratch = await createTestDatabase('empty');
  config = {
    driveRoot: drive,
    publicKeyFile: pub,
    pgBinDir: process.env['PG_BIN_DIR'],
    connectionString: asApp(urlFor(fx.db.name)),
    filesDir: fx.filesDir,
    restoreTestUrl: urlFor(scratch.name),
  };
  // A day of trading, so every check has rows to check.
  await fx.addUser('rt-cash', ['cashier']);
  await fx.addUser('rt-partner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('rt-cash');
  const shop = new TradingShop(fx, owner, cashier, { username: 'rt-partner', pin: '1357' }, 'RT');
  await shop.setUp({ recipe: true });
  await shop.openShift();
  const p = await shop.sale(2, 'cash');
  await shop.sale(1, 'card_manual');
  await shop.refund(p, 50);
  await shop.closeShift();
  return () => {
    rmSync(work, { recursive: true, force: true });
  };
}, 120_000);
afterAll(async () => {
  await scratch.drop();
  await fx.close();
});

describe('the weekly test restore (AT-81)', () => {
  it('restores the dump into the scratch database and every integrity check passes', async () => {
    const r = await runDump(fx.pool, config, new Date(), { testRestore: true });
    expect(r.status, String(r.error)).toBe('succeeded');
    expect(r.restoreTest).toMatchObject({ ok: true, failed: [] });
    const { rows } = await fx.pool.query(
      `SELECT status, source_run_id::text AS source FROM cl.backup_runs WHERE id = $1`,
      [r.restoreTest?.runId],
    );
    expect(rows[0]).toEqual({ status: 'succeeded', source: r.runId });
  }, 120_000);

  it('each of the six checks catches a broken copy', async () => {
    // A copy of the database, broken on purpose in six ways (triggers off on the copy only).
    const copy = await createTestDatabase('empty');
    const pool = new pg.Pool({ connectionString: urlFor(copy.name), max: 2 });
    try {
      const r = await runDump(fx.pool, { ...config, restoreTestUrl: undefined }, new Date());
      const plain = Buffer.from(await decrypt(keyText, readFileSync(r.path ?? '')));
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const { spawnSync } = await import('node:child_process');
      const bin = process.env['PG_BIN_DIR'];
      const restore = spawnSync(
        bin ? join(bin, 'pg_restore') : 'pg_restore',
        ['--no-owner', '--no-privileges', `--dbname=${urlFor(copy.name)}`],
        { input: plain },
      );
      expect(restore.status, restore.stderr.toString()).toBe(0);
      expect((await integrityChecks(pool)).ok).toBe(true);
      for (const t of [
        'inventory_balances',
        'payments',
        'cash_shifts',
        'document_counters',
        'ledger_entries',
      ])
        await pool.query(`ALTER TABLE cl.${t} DISABLE TRIGGER USER`);
      await pool.query(
        'UPDATE cl.inventory_balances SET on_hand = on_hand + 1 WHERE item_id = (SELECT min(item_id) FROM cl.inventory_balances)',
      );
      await pool.query(
        'DELETE FROM cl.payments WHERE id = (SELECT max(id) FROM cl.payments WHERE id NOT IN (SELECT payment_id FROM cl.refunds))',
      );
      await pool.query(
        'ALTER TABLE cl.cash_shifts DROP CONSTRAINT shift_variance_formula, DROP CONSTRAINT shift_variance_approved',
      );
      await pool.query('UPDATE cl.cash_shifts SET expected_cash = expected_cash + 1');
      await pool.query(`UPDATE cl.document_counters SET next_value = 1 WHERE kind = 'invoice'`);
      await pool.query(
        'ALTER TABLE cl.payments ADD CONSTRAINT broken_fk FOREIGN KEY (invoice_id) REFERENCES cl.invoices NOT VALID',
      );
      const report = await integrityChecks(pool);
      expect(report.ok).toBe(false);
      expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        'Stock balances = their movements',
        'Settled bills add up and are paid',
        'Closed shifts: expected cash recomputes',
        'Ledger: one entry per money source',
        'Document counters are past every number issued',
        'No orphaned references',
      ]);
    } finally {
      await pool.end();
      await copy.drop();
    }
  }, 120_000);

  it('a failed test restore raises the banner and tells the owner', async () => {
    await fx.pool.query(
      `INSERT INTO cl.backup_runs (kind, status, finished_at, error) VALUES ('restore_test', 'failed', now(), 'Ledger: 1 sources differ')`,
    );
    const watch = new BackupWatch({ db: fx.pool, driveRoot: drive, publicKeyFile: pub });
    const s = await watch.status();
    expect(s.problem).toBe('restore_test_failed');
    expect(s.lastTestRestore).toEqual({ status: 'failed', error: 'Ledger: 1 sources differ' });
    await runDump(fx.pool, config, new Date(), { testRestore: true });
    expect((await watch.status()).problem).toBeNull();
  }, 120_000);
});

describe('the two drives (BACKUP_RECOVERY.md §3)', () => {
  it('each gets an id and a letter; a drive without a base backup needs one', async () => {
    const a = await identifyDrive(fx.pool, drive);
    expect(a).toMatchObject({ label: 'A' });
    expect(await identifyDrive(fx.pool, drive)).toEqual(a);
    expect(await identifyDrive(fx.pool, join(work, 'nothing'))).toBeNull();
    expect(await baseBackupDue(fx.pool, drive)).toBe(true);
    await fx.pool.query(
      `INSERT INTO cl.backup_runs (kind, status, finished_at, path, size_bytes, sha256, drive_id, drive_label)
       VALUES ('base_backup', 'succeeded', now(), $1, 1, repeat('0', 64), $2, 'A')`,
      [join(drive, 'CoffeeLounge', 'base', 'x', 'base.tar.gz.age'), a?.id],
    );
    expect(await baseBackupDue(fx.pool, drive)).toBe(false);
    const second = join(work, 'B2');
    mkdirSync(second);
    expect(await identifyDrive(fx.pool, second)).toMatchObject({ label: 'B' });
    expect(await baseBackupDue(fx.pool, second)).toBe(true);
    await fx.db.client.query(`DELETE FROM cl.backup_runs WHERE kind = 'base_backup'`);
  });

  it('a base backup: the whole cluster with its WAL, encrypted (where this login may replicate)', async (ctx) => {
    const { rows } = await fx.db.client.query<{ ok: boolean }>(
      'SELECT rolreplication OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
    );
    if (!rows[0]?.ok) {
      ctx.skip(); // the development login cannot replicate; CI's can (PLAN 7.2)
      return;
    }
    const r = await runBaseBackup(
      fx.pool,
      { ...config, replicationUrl: urlFor(fx.db.name) },
      new Date(),
    );
    expect(r.status, String(r.error)).toBe('succeeded');
    const tar = gunzipSync(await decrypt(keyText, readFileSync(r.path ?? '')));
    expect(tar.includes(Buffer.from('PG_VERSION'))).toBe(true);
    // And it unpacks into a whole data folder, as a point-in-time restore does (step 7.3).
    const prepared = await prepareBaseRestore({
      driveRoot: drive,
      keyText,
      dataDir: join(work, 'pgdata-from-base'),
      target: 'latest',
      restoreCommand: 'x',
    });
    expect(prepared.files).toBeGreaterThan(500);
    expect(readFileSync(join(work, 'pgdata-from-base', 'PG_VERSION'), 'utf8').trim()).toBe('17');
    expect(readFileSync(join(work, 'pgdata-from-base', 'global', 'pg_control')).length).toBe(8192);
    expect(await baseBackupDue(fx.pool, drive)).toBe(false);
  }, 300_000);
});

describe('retention (BACKUP_RECOVERY.md §2)', () => {
  it('14 days + 8 Mondays + 12 firsts of the month', () => {
    const dumps = Array.from({ length: 400 }, (_, i) => ({
      id: String(i),
      started_at: new Date(Date.UTC(2026, 9, 30, 0, 0) - i * 86400_000),
    }));
    const keep = dumpsToKeep(dumps);
    const days = [...keep]
      .map((id) => dumps[Number(id)]?.started_at.toISOString().slice(0, 10))
      .sort();
    expect(days.filter((d) => (d ?? '') >= '2026-10-17')).toHaveLength(14);
    expect(days.filter((d) => d?.endsWith('-01'))).toHaveLength(12);
    expect(keep.size).toBeLessThanOrEqual(14 + 8 + 12);
    expect(keep.size).toBeGreaterThan(14 + 8);
  });

  it('prunes old dumps, base backups and WAL on this drive, only after the newest is verified', async () => {
    const root = join(drive, 'CoffeeLounge');
    await fx.db.client.query(
      `UPDATE cl.backup_runs SET pruned_at = now() WHERE kind IN ('dump', 'base_backup')`,
    );
    const add = async (kind: string, path: string, at: Date, verified = true) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'x');
      await fx.pool.query(
        `INSERT INTO cl.backup_runs (kind, status, started_at, finished_at, path, size_bytes, sha256, verified_at)
         VALUES ($1, 'succeeded', $2, $2, $3, 1, repeat('0', 64), CASE WHEN $4 THEN $2::timestamptz END)`,
        [kind, at, path, verified],
      );
    };
    const day = (n: number) => new Date(Date.UTC(2027, 0, 31, 0, 0) - n * 86400_000);
    for (let n = 0; n < 40; n++)
      await add('dump', join(root, 'dumps', `old-${String(n)}.dump.age`), day(n));
    for (let n = 0; n < 3; n++)
      await add('base_backup', join(root, 'base', `b${String(n)}`, 'base.tar.gz.age'), day(n * 7));
    mkdirSync(join(root, 'wal'), { recursive: true });
    const oldWal = join(root, 'wal', '000000010000000000000001.gz.age');
    const newWal = join(root, 'wal', '000000010000000000000099.gz.age');
    writeFileSync(oldWal, 'x');
    writeFileSync(newWal, 'x');
    utimesSync(oldWal, day(30), day(30));
    utimesSync(newWal, day(0), day(0));
    const result = await pruneBackups(fx.pool, drive);
    expect(result.skipped).toBeNull();
    expect(result.baseBackups).toBe(1); // the third base backup
    expect(result.walFiles).toBe(1); // older than the oldest kept base backup
    expect(result.dumps).toBeGreaterThan(10);
    expect(readFileSync(newWal, 'utf8')).toBe('x');
    // A newer dump not yet verified: nothing is pruned.
    await add(
      'dump',
      join(root, 'dumps', 'newest.dump.age'),
      new Date(Date.UTC(2027, 1, 1)),
      false,
    );
    expect((await pruneBackups(fx.pool, drive)).skipped).toMatch(/not verified/);
  });
});

describe('the off-site copy (D-23, P7-2)', () => {
  it('signs as AWS documents it (SigV4 example "GET Object")', () => {
    expect(
      signV4({
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        headers: {
          range: 'bytes=0-9',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20130524T000000Z',
        },
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        amzDate: '20130524T000000Z',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }),
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('waits while the bucket cannot be reached, then copies the newest dump once', async () => {
    const puts: { path: string; auth: string; body: Buffer }[] = [];
    const leaf = issueServerCertificate({
      caCertificatePem: bucketCa.certificatePem,
      caPrivateKeyPem: bucketCa.privateKeyPem,
      caPassphrase: 'x-test-passphrase',
      ips: ['127.0.0.1'],
      days: 30,
    });
    const server: Server = createServer(
      { key: leaf.privateKeyPem, cert: leaf.certificatePem },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          puts.push({
            path: req.url ?? '',
            auth: String(req.headers.authorization),
            body: Buffer.concat(chunks),
          });
          res.statusCode = 200;
          res.end();
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const deps = { keyFile: fx.mail.keyFile, tls: { ca: bucketCa.certificatePem } };
    try {
      expect(await copyOffsite(fx.pool, deps)).toBe('not set up');
      // The retention test's stand-in files are not real dumps: tonight's real one goes out.
      await fx.db.client.query(`UPDATE cl.backup_runs SET pruned_at = now() WHERE kind = 'dump'`);
      expect((await runDump(fx.pool, config, new Date())).status).toBe('succeeded');
      const saved = await owner.call({
        method: 'PUT',
        url: '/api/staff/v1/backup/offsite',
        payload: {
          endpoint: `https://127.0.0.1:${String(port)}`,
          region: 'auto',
          bucket: 'shop-backups',
          accessKeyId: 'KEYID123',
          secretAccessKey: 'super-secret-value',
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain('super-secret-value');
      const { rows } = await fx.pool.query<{ s: string }>(
        'SELECT secret_sealed AS s FROM cl.offsite_target',
      );
      expect(rows[0]?.s).not.toContain('super-secret-value');
      // The connection down: the copy waits, one row, not an alarm.
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      expect(await copyOffsite(fx.pool, deps)).toMatch(/^pending: /);
      expect(await copyOffsite(fx.pool, deps)).toMatch(/^pending: /);
      const { rows: waiting } = await fx.pool.query(
        `SELECT 1 FROM cl.backup_runs WHERE kind = 'offsite_copy'`,
      );
      expect(waiting).toHaveLength(1);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      const copied = await copyOffsite(fx.pool, deps);
      expect(copied).toMatch(/^copied coffee-lounge\/cl-\d{8}-\d{4}\.dump\.age$/);
      expect(puts.at(-1)?.path).toMatch(/^\/shop-backups\/coffee-lounge\/cl-/);
      expect(puts.at(-1)?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=KEYID123\//);
      expect(puts.at(-1)?.body.toString('latin1')).toContain('age-encryption.org/v1');
      expect(await copyOffsite(fx.pool, deps)).toBe('up to date');
      const test = await owner.call({ method: 'POST', url: '/api/staff/v1/backup/offsite/test' });
      expect(test.statusCode, test.body).toBe(200);
      const view = await owner.call({ method: 'GET', url: '/api/staff/v1/backup/offsite' });
      expect(view.json<{ last: { status: string } }>().last.status).toBe('succeeded');
    } finally {
      server.close();
    }
  }, 120_000);
});
