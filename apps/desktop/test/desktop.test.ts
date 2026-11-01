import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadDesktopConfig, parseDesktopConfig } from '../src/config.ts';
import { chainOf, chromiumAcceptable, pinnedVerdict } from '../src/pinning.ts';
import {
  classifyLoadFailure,
  isAllowedDownload,
  isAllowedRequest,
  isServerPage,
  safeFileName,
  WEB_CSP,
  withCsp,
} from '../src/policy.ts';
import {
  coreRunning,
  MAX_START_ATTEMPTS,
  parseScQuery,
  ServiceSupervisor,
  START_RETRY_MS,
  type ServiceRow,
} from '../src/services.ts';
import { makePki, type Pki } from './pki.ts';

let pki: Pki;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-desktop-'));
  pki = makePki(join(dir, 'pki'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('certificate pinning to the shop root', () => {
  const pin = () => ({ host: '127.0.0.1', root: new X509Certificate(pki.rootPem) });

  it('accepts the server certificate signed by the shop root, directly or via an intermediate', () => {
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.leafPem] }, pin())).toEqual({
      ok: true,
    });
    expect(
      pinnedVerdict(
        { hostname: '127.0.0.1', chain: [pki.viaIntermediatePem, pki.intermediatePem] },
        pin(),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a certificate from another root, even one with the same name', () => {
    const verdict = pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.impostorLeafPem] }, pin());
    expect(verdict).toEqual({ ok: false, reason: 'certificate is not signed by the shop root' });
    // ...also when the impostor sends its own root along.
    expect(
      pinnedVerdict(
        { hostname: '127.0.0.1', chain: [pki.impostorLeafPem, pki.impostorRootPem] },
        pin(),
      ).ok,
    ).toBe(false);
  });

  it('refuses a shop certificate for a different address, any other host, and expired ones', () => {
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.otherHostPem] }, pin())).toEqual({
      ok: false,
      reason: 'certificate is not for 127.0.0.1',
    });
    expect(pinnedVerdict({ hostname: 'example.com', chain: [pki.leafPem] }, pin()).ok).toBe(false);
    const in2030 = new Date('2030-01-01T00:00:00Z');
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.leafPem] }, pin(), in2030)).toEqual({
      ok: false,
      reason: 'certificate expired or not yet valid',
    });
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: ['garbage'] }, pin()).ok).toBe(false);
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: [] }, pin()).ok).toBe(false);
  });

  it('refuses a shop certificate signed with SHA-1', () => {
    expect(new X509Certificate(pki.weakPem).signatureAlgorithm).toMatch(/SHA1/i);
    expect(pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.weakPem] }, pin())).toEqual({
      ok: false,
      reason: 'certificate uses a weak signature',
    });
    expect(new X509Certificate(pki.leafPem).signatureAlgorithm).toMatch(/SHA256/i);
  });

  it('overrides only the unknown-root verdict from Chromium', () => {
    expect(chromiumAcceptable(0)).toBe(true);
    expect(chromiumAcceptable(-202)).toBe(true); // AUTHORITY_INVALID
    expect(chromiumAcceptable(-200)).toBe(false); // COMMON_NAME_INVALID
    expect(chromiumAcceptable(-201)).toBe(false); // DATE_INVALID
    expect(chromiumAcceptable(-208)).toBe(false); // WEAK_SIGNATURE_ALGORITHM
  });

  it('a chain with an intermediate missing does not verify', () => {
    expect(
      pinnedVerdict({ hostname: '127.0.0.1', chain: [pki.viaIntermediatePem] }, pin()).ok,
    ).toBe(false);
  });

  it('flattens the chain Electron passes as linked issuers', () => {
    const root = { data: 'R' } as { data: string; issuerCert?: unknown };
    root.issuerCert = root; // self-signed
    expect(chainOf({ data: 'L', issuerCert: { data: 'I', issuerCert: root } })).toEqual([
      'L',
      'I',
      'R',
    ]);
    expect(chainOf({ data: 'L' })).toEqual(['L']);
  });
});

describe('certificates made by the shop certificate tool (installer)', () => {
  it('are pinned and accepted for both server addresses', () => {
    const out = join(dir, 'from-tool');
    const pass = 'correct horse battery';
    const run = (args: string[], input: string) =>
      spawnSync(process.execPath, ['src/cli/certs.ts', ...args], {
        cwd: fileURLToPath(new URL('../../server', import.meta.url)),
        input,
        encoding: 'utf8',
      });
    expect(run(['create-ca', '--out', join(out, 'ca')], `${pass}\n${pass}\n`).status).toBe(0);
    expect(
      run(
        [
          'issue-server',
          '--ca-dir',
          join(out, 'ca'),
          '--out',
          join(out, 'srv'),
          '--ip',
          '192.168.100.250',
          '--ip',
          '127.0.0.1',
        ],
        `${pass}\n`,
      ).status,
    ).toBe(0);
    const root = new X509Certificate(readFileSync(join(out, 'ca', 'coffee-lounge-root.pem')));
    const leaf = readFileSync(join(out, 'srv', 'server.pem'), 'utf8');
    for (const host of ['127.0.0.1', '192.168.100.250']) {
      expect(pinnedVerdict({ hostname: host, chain: [leaf] }, { host, root })).toEqual({
        ok: true,
      });
    }
  });
});

describe('start-up screen: services (step 8.5)', () => {
  const output = (state: string) => ({
    code: 0,
    stdout: `SERVICE_NAME: x\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : ${state}\n        WIN32_EXIT_CODE    : 0  (0x0)\n`,
  });
  const NAMES = ['postgresql-x64-17', 'coffeelounge-api', 'coffeelounge-worker', 'Spooler'];

  /** A pretend sc.exe; `start` answers with startCode and then the service runs. */
  function world(stopped: string[], startCode = 0) {
    const down = new Set(stopped);
    const calls: string[] = [];
    const sc = (args: readonly string[]) => {
      const [verb = '', name = ''] = args;
      calls.push(`${verb} ${name}`);
      if (verb === 'start') {
        if (startCode === 0) down.delete(name);
        return Promise.resolve({ code: startCode, stdout: '' });
      }
      return Promise.resolve(output(down.has(name) ? '1  STOPPED' : '4  RUNNING'));
    };
    return { sc, calls };
  }
  const state = (rows: ServiceRow[], id: string) => rows.find((r) => r.id === id);

  it('reads the state by number, in any Windows language', () => {
    expect(parseScQuery(output('4  RUNNING'))).toBe('running');
    expect(parseScQuery(output('1  STOPPED'))).toBe('stopped');
    expect(parseScQuery(output('2  START_PENDING'))).toBe('pending');
    expect(
      parseScQuery({ code: 0, stdout: 'SERVICE_NAME: x\n TYP : 10  W\n STATUS : 4  RUNNING\n' }),
    ).toBe('running');
    expect(parseScQuery({ code: 1060, stdout: '' })).toBe('missing');
    expect(parseScQuery({ code: null, stdout: '' })).toBe('unknown');
    expect(parseScQuery({ code: 0, stdout: 'nonsense' })).toBe('unknown');
  });

  it('leaves running services alone and only ever queries and starts the fixed names', async () => {
    const { sc, calls } = world([]);
    const rows = await new ServiceSupervisor(sc, () => false).check();
    expect(coreRunning(rows)).toBe(true);
    expect(calls).toEqual(NAMES.map((n) => `query ${n}`));
  });

  it('starts the database first, and the others only once it runs', async () => {
    const { sc, calls } = world(['postgresql-x64-17', 'coffeelounge-api']);
    const supervisor = new ServiceSupervisor(sc, () => false);
    const first = await supervisor.check();
    expect(calls).toContain('start postgresql-x64-17');
    expect(calls).not.toContain('start coffeelounge-api');
    expect(state(first, 'server')?.message).toBe('Waiting for the database…');
    expect(coreRunning(first)).toBe(false);
    await supervisor.check();
    expect(calls).toContain('start coffeelounge-api');
    expect(coreRunning(await supervisor.check())).toBe(true);
  });

  it('never starts anything during an upgrade or restore', async () => {
    const { sc, calls } = world(['postgresql-x64-17', 'coffeelounge-api']);
    const rows = await new ServiceSupervisor(sc, () => true).check();
    expect(calls.filter((c) => c.startsWith('start'))).toEqual([]);
    expect(state(rows, 'database')?.state).toBe('working');
  });

  it('never starts the print service; a stopped one is shown but holds nothing back', async () => {
    const { sc, calls } = world(['Spooler']);
    const rows = await new ServiceSupervisor(sc, () => false).check();
    expect(calls).not.toContain('start Spooler');
    expect(state(rows, 'printer')?.state).toBe('problem');
    expect(coreRunning(rows)).toBe(true);
  });

  it('says so when this account lacks the right, without asking again', async () => {
    const { sc, calls } = world(['coffeelounge-api'], 5);
    const supervisor = new ServiceSupervisor(sc, () => false);
    expect(state(await supervisor.check(), 'server')?.message).toMatch(/may not start/);
    expect(state(await supervisor.check(), 'server')?.state).toBe('problem');
    expect(calls.filter((c) => c === 'start coffeelounge-api')).toHaveLength(1);
  });

  it('gives up after three spaced attempts in plain words; "Try again" starts over', async () => {
    let now = 0;
    const { sc, calls } = world(['coffeelounge-api'], 1067);
    const supervisor = new ServiceSupervisor(
      sc,
      () => false,
      () => now,
    );
    const starts = () => calls.filter((c) => c === 'start coffeelounge-api').length;
    await supervisor.check();
    await supervisor.check(); // too soon
    expect(starts()).toBe(1);
    now += START_RETRY_MS;
    await supervisor.check();
    now += START_RETRY_MS;
    await supervisor.check();
    expect(starts()).toBe(MAX_START_ATTEMPTS);
    now += START_RETRY_MS;
    const rows = await supervisor.check();
    expect(starts()).toBe(MAX_START_ATTEMPTS);
    expect(state(rows, 'server')?.message).toMatch(/will not start\. Restart this PC/);
    supervisor.resetAttempts();
    await supervisor.check();
    expect(starts()).toBe(MAX_START_ATTEMPTS + 1);
  });

  it('a service that is not installed sends for the technician', async () => {
    const sc = () => Promise.resolve({ code: 1060, stdout: '' });
    const rows = await new ServiceSupervisor(sc, () => false).check();
    expect(state(rows, 'database')?.message).toMatch(/not installed.*technician/);
  });
});

describe('configuration', () => {
  const readRoot = () => Promise.resolve(pki.rootPem);

  it('reads the server origin, pinned root and window mode', async () => {
    const file = join(dir, 'desktop.json');
    writeFileSync(
      file,
      JSON.stringify({
        serverUrl: 'https://127.0.0.1:8443',
        caCertFile: 'pki/root.pem',
        fullscreen: true,
      }),
    );
    const cfg = await loadDesktopConfig(file);
    expect(cfg.serverOrigin).toBe('https://127.0.0.1:8443');
    expect(cfg.serverHost).toBe('127.0.0.1');
    expect(cfg.fullscreen).toBe(true);
    expect(cfg.root?.subject).toContain('Coffee Lounge Test Root');
  });

  it('reads a settings file saved with a byte-order mark (Notepad, PowerShell 5.1)', async () => {
    const file = join(dir, 'bom.json');
    writeFileSync(file, '\uFEFF' + JSON.stringify({ serverUrl: 'http://127.0.0.1:8443' }));
    expect((await loadDesktopConfig(file)).serverOrigin).toBe('http://127.0.0.1:8443');
  });

  it('refuses https without a root, a non-CA root, paths, other schemes, remote http', async () => {
    const bad = async (raw: Record<string, unknown>, read = readRoot) =>
      parseDesktopConfig(raw, read).catch((e: unknown) => e);
    expect(await bad({ serverUrl: 'https://127.0.0.1:8443' })).toBeInstanceOf(ConfigError);
    expect(
      await bad({ serverUrl: 'https://127.0.0.1:8443', caCertFile: 'x' }, () =>
        Promise.resolve(pki.leafPem),
      ),
    ).toMatchObject({ message: 'caCertFile is not a CA certificate' });
    expect(await bad({ serverUrl: 'https://127.0.0.1:8443/app', caCertFile: 'x' })).toBeInstanceOf(
      ConfigError,
    );
    expect(await bad({ serverUrl: 'ftp://127.0.0.1' })).toBeInstanceOf(ConfigError);
    expect(await bad({ serverUrl: 'http://192.168.100.250:8443' })).toMatchObject({
      message: 'Plain http is allowed only for a loopback address (development)',
    });
    expect(await bad({ serverUrl: 'not a url' })).toBeInstanceOf(ConfigError);
    expect(await bad({ serverUrl: 'http://127.0.0.1:8443', fullscreen: 'yes' })).toBeInstanceOf(
      ConfigError,
    );
    await expect(loadDesktopConfig(join(dir, 'missing.json'))).rejects.toBeInstanceOf(ConfigError);
  });

  it('allows plain http to a loopback server for development, with nothing pinned', async () => {
    const cfg = await parseDesktopConfig({ serverUrl: 'http://127.0.0.1:8443' }, readRoot);
    expect(cfg).toMatchObject({
      serverOrigin: 'http://127.0.0.1:8443',
      root: null,
      fullscreen: false,
    });
  });
});

describe('navigation and network lock', () => {
  const origin = 'https://127.0.0.1:8443';
  const staticUrl = 'file:///Applications/CoffeeLounge/static/';

  it('allows only the server origin for pages', () => {
    expect(isServerPage('https://127.0.0.1:8443/login', origin)).toBe(true);
    expect(isServerPage('https://127.0.0.1:8080/', origin)).toBe(false); // customer port
    expect(isServerPage('http://127.0.0.1:8443/', origin)).toBe(false); // downgrade
    expect(isServerPage('https://example.com/', origin)).toBe(false);
    expect(isServerPage('javascript:alert(1)', origin)).toBe(false);
    expect(isServerPage('nonsense', origin)).toBe(false);
  });

  it('allows requests to the server, inline images and the app’s own static files only', () => {
    const allowed = (url: string) => isAllowedRequest(url, origin, staticUrl);
    expect(allowed('https://127.0.0.1:8443/api/staff/v1/auth/me')).toBe(true);
    expect(allowed('data:image/png;base64,AAAA')).toBe(true);
    expect(allowed('data:text/html,<script>')).toBe(false);
    expect(allowed('file:///Applications/CoffeeLounge/static/unavailable.html?reason=x')).toBe(
      true,
    );
    expect(allowed('file:///Applications/CoffeeLounge/static/../../../etc/passwd')).toBe(false);
    expect(allowed('file:///etc/passwd')).toBe(false);
    expect(allowed('https://fonts.googleapis.com/css')).toBe(false);
    expect(allowed('ws://127.0.0.1:8443/')).toBe(false);
  });

  it('adds the CSP to a document that arrived without one, and keeps an existing one', () => {
    expect(withCsp({ 'Content-Type': ['text/html'] })).toEqual({
      headers: { 'Content-Type': ['text/html'], 'Content-Security-Policy': [WEB_CSP] },
      added: true,
    });
    const own = { 'content-security-policy': ["default-src 'none'"] };
    expect(withCsp(own)).toEqual({ headers: own, added: false });
  });

  it('downloads only the app’s own exports and attached bills, from the server (P6-7)', () => {
    const ok = (...urls: string[]) => isAllowedDownload(urls, origin);
    expect(
      ok(`${origin}/api/staff/v1/reports/sales-by-day/export?format=csv&from=2026-10-01`),
    ).toBe(true);
    expect(ok(`${origin}/api/staff/v1/reports/day-end/export?format=pdf`)).toBe(true);
    expect(ok(`${origin}/api/staff/v1/expenses/42/attachment`)).toBe(true);
    expect(ok(`${origin}/api/staff/v1/reports/sales-by-day?from=2026-10-01`)).toBe(false);
    expect(ok(`${origin}/api/staff/v1/expenses/42/attachment/../../auth/me`)).toBe(false);
    expect(ok('https://example.com/api/staff/v1/reports/bills/export')).toBe(false);
    expect(ok('http://127.0.0.1:8443/api/staff/v1/reports/bills/export')).toBe(false);
    expect(ok('blob:https://127.0.0.1:8443/1234')).toBe(false);
    expect(ok('data:application/pdf;base64,AAAA')).toBe(false);
    // A redirect away from the list is refused even if it started on it.
    expect(ok(`${origin}/api/staff/v1/reports/bills/export`, 'https://example.com/file.exe')).toBe(
      false,
    );
    expect(ok()).toBe(false);
  });

  it('saves under a name safe on Windows', () => {
    expect(safeFileName('sales-by-day_2026-10-01.csv')).toBe('sales-by-day_2026-10-01.csv');
    expect(safeFileName('..\\..\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFileName('../../.bashrc')).toBe('bashrc');
    expect(safeFileName('bill: <March>?.pdf')).toBe('bill_ _March__.pdf');
    expect(safeFileName('CON.csv')).toBe('_CON.csv');
    expect(safeFileName('')).toBe('download');
    expect(safeFileName(`${'x'.repeat(300)}.pdf`)).toHaveLength(120);
  });

  it('tells unreachable servers from certificate problems', () => {
    expect(classifyLoadFailure(-102)).toBe('unreachable'); // CONNECTION_REFUSED
    expect(classifyLoadFailure(-118)).toBe('unreachable'); // CONNECTION_TIMED_OUT
    expect(classifyLoadFailure(-7)).toBe('unreachable');
    expect(classifyLoadFailure(-202)).toBe('certificate'); // CERT_AUTHORITY_INVALID
    expect(classifyLoadFailure(-3)).toBeNull(); // ABORTED: our own navigation
    expect(classifyLoadFailure(-2)).toBe('other');
  });
});
