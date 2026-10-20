/** Shop root CA and server certificate (LOCAL_LAN_HOSTING.md §5): profile, chain and TLS. */
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApps } from '../../src/platform/app.ts';
import { createPool } from '../../src/platform/db/pool.ts';
import { Readiness } from '../../src/platform/readiness.ts';
import {
  createRootCa,
  issueServerCertificate,
  type IssuedKeyPair,
} from '../../src/platform/x509.ts';

const PASS = 'correct horse battery';
const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
let dir: string;
let root: IssuedKeyPair;
let server: IssuedKeyPair;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-x509-'));
  root = createRootCa({ passphrase: PASS });
  server = issueServerCertificate({
    caCertificatePem: root.certificatePem,
    caPrivateKeyPem: root.privateKeyPem,
    caPassphrase: PASS,
    ips: ['192.168.100.250', '127.0.0.1'],
  });
  writeFileSync(join(dir, 'root.pem'), root.certificatePem);
  writeFileSync(join(dir, 'server.pem'), server.certificatePem);
  writeFileSync(join(dir, 'server.key'), server.privateKeyPem);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const days = (c: X509Certificate) =>
  Math.round((Date.parse(c.validTo) - Date.parse(c.validFrom)) / 86_400_000);

describe('root CA', () => {
  it('is a self-signed P-256/SHA-256 CA valid for about ten years', () => {
    const ca = new X509Certificate(root.certificatePem);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe('O=Coffee Lounge\nCN=Coffee Lounge Root CA');
    expect(ca.issuer).toBe(ca.subject);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(ca.signatureAlgorithm).toBe('ecdsa-with-SHA256');
    expect(days(ca)).toBeGreaterThanOrEqual(3652);
  });

  it('keeps its private key encrypted, and refuses a short passphrase', () => {
    expect(root.privateKeyPem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(() => createRootCa({ passphrase: 'short' })).toThrow(/at least 12/);
  });
});

describe('server certificate', () => {
  it('names both addresses, serves TLS only, and chains to the root', () => {
    const cert = new X509Certificate(server.certificatePem);
    const ca = new X509Certificate(root.certificatePem);
    expect(cert.subjectAltName).toBe('IP Address:192.168.100.250, IP Address:127.0.0.1');
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.checkIP('192.168.100.250')).toBe('192.168.100.250');
    expect(cert.checkIP('192.168.100.251')).toBeUndefined();
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']); // serverAuth only
    expect(cert.signatureAlgorithm).toBe('ecdsa-with-SHA256');
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(days(cert)).toBe(731); // 730 days plus one day of clock tolerance
  });

  it('passes openssl\x27s server-certificate verification', () => {
    const out = execFileSync(
      'openssl',
      [
        'verify',
        '-CAfile',
        join(dir, 'root.pem'),
        '-purpose',
        'sslserver',
        join(dir, 'server.pem'),
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim()).toMatch(/: OK$/);
    const text = execFileSync(
      'openssl',
      ['x509', '-in', join(dir, 'server.pem'), '-noout', '-text'],
      {
        encoding: 'utf8',
      },
    );
    expect(text).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(text).toMatch(/Key Usage: critical\s+Digital Signature/);
    expect(text).toMatch(/TLS Web Server Authentication/);
  });

  it('refuses bad requests: too long, wrong passphrase, foreign key, IPv6, not a CA', () => {
    const base = {
      caCertificatePem: root.certificatePem,
      caPrivateKeyPem: root.privateKeyPem,
      caPassphrase: PASS,
      ips: ['127.0.0.1'],
    };
    expect(() => issueServerCertificate({ ...base, days: 826 })).toThrow(/1–825 days/);
    expect(() => issueServerCertificate({ ...base, caPassphrase: 'wrong passphrase!' })).toThrow();
    const other = createRootCa({ passphrase: PASS });
    expect(() => issueServerCertificate({ ...base, caPrivateKeyPem: other.privateKeyPem })).toThrow(
      /does not belong/,
    );
    expect(() => issueServerCertificate({ ...base, ips: ['::1'] })).toThrow(/IPv4/);
    expect(() => issueServerCertificate({ ...base, ips: [] })).toThrow(/At least one/);
    expect(() =>
      issueServerCertificate({ ...base, caCertificatePem: server.certificatePem }),
    ).toThrow(/not a certificate authority/);
  });
});

function fetchStatus(url: string, ca?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpsGet(url, ca ? { ca } : {}, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

describe('TLS with the shop certificates', () => {
  it('a client trusting only the shop root connects; one without it is refused', async () => {
    const tls = https.createServer(
      { cert: server.certificatePem, key: server.privateKeyPem },
      (_req, res) => {
        res.end('ok');
      },
    );
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    const { port } = tls.address() as AddressInfo;
    try {
      expect(await fetchStatus(`https://127.0.0.1:${String(port)}/`, root.certificatePem)).toBe(
        200,
      );
      await expect(fetchStatus(`https://127.0.0.1:${String(port)}/`)).rejects.toMatchObject({
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      });
    } finally {
      await new Promise((r) => tls.close(r));
    }
  });

  it('the staff listener serves HTTPS/HTTP2 with them', async () => {
    const pool = createPool({ connectionString: 'postgres://unused@127.0.0.1:1/x', max: 1 });
    const readiness = new Readiness();
    const { staff } = buildApps({
      config: {
        LOG_LEVEL: 'silent',
        STAFF_TLS_CERT: join(dir, 'server.pem'),
        STAFF_TLS_KEY: join(dir, 'server.key'),
      },
      pool,
      readiness,
      logging: false,
    });
    await staff.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = staff.server.address() as AddressInfo;
      expect(
        await fetchStatus(`https://127.0.0.1:${String(port)}/health/live`, root.certificatePem),
      ).toBe(200);
    } finally {
      await staff.close();
      await pool.end();
    }
  });
});

describe('certs command line', () => {
  const run = (args: string[], stdin: string) =>
    spawnSync(process.execPath, ['src/cli/certs.ts', ...args], {
      cwd: SERVER_DIR,
      input: stdin,
      encoding: 'utf8',
    });

  it('creates a CA and a server certificate, and never overwrites a key', () => {
    const ca = join(dir, 'cli-ca');
    const out = join(dir, 'cli-server');
    const created = run(['create-ca', '--out', ca], `${PASS}\n${PASS}\n`);
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toMatch(/Root CA created/);

    const issued = run(
      [
        'issue-server',
        '--ca-dir',
        ca,
        '--out',
        out,
        '--ip',
        '192.168.100.250',
        '--ip',
        '127.0.0.1',
      ],
      `${PASS}\n`,
    );
    expect(issued.status, issued.stderr).toBe(0);
    const cert = new X509Certificate(readFileSync(join(out, 'server.pem')));
    expect(
      cert.verify(new X509Certificate(readFileSync(join(ca, 'coffee-lounge-root.pem'))).publicKey),
    ).toBe(true);

    const again = run(['create-ca', '--out', ca], `${PASS}\n${PASS}\n`);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/EEXIST/);
    const mismatch = run(['create-ca', '--out', join(dir, 'x')], `${PASS}\nsomething else\n`);
    expect(mismatch.stderr).toMatch(/do not match/);

    // Unattended (installer): the passphrase comes from the environment, not stdin.
    const viaEnv = spawnSync(
      process.execPath,
      ['src/cli/certs.ts', 'create-ca', '--out', join(dir, 'env-ca')],
      {
        cwd: SERVER_DIR,
        input: '',
        encoding: 'utf8',
        env: { ...process.env, CL_CA_PASSPHRASE: PASS },
      },
    );
    expect(viaEnv.status, viaEnv.stderr).toBe(0);
  });
});
