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
  isAllowedRequest,
  isServerPage,
  WEB_CSP,
  withCsp,
} from '../src/policy.ts';
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

  it('tells unreachable servers from certificate problems', () => {
    expect(classifyLoadFailure(-102)).toBe('unreachable'); // CONNECTION_REFUSED
    expect(classifyLoadFailure(-118)).toBe('unreachable'); // CONNECTION_TIMED_OUT
    expect(classifyLoadFailure(-7)).toBe('unreachable');
    expect(classifyLoadFailure(-202)).toBe('certificate'); // CERT_AUTHORITY_INVALID
    expect(classifyLoadFailure(-3)).toBeNull(); // ABORTED: our own navigation
    expect(classifyLoadFailure(-2)).toBe('other');
  });
});
